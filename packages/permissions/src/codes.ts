/**
 * The permission catalogue. Seeded into the `permissions` table by
 * `packages/db/prisma/seed.ts`; this file is the single source of truth.
 *
 * Format: `<module>.<resource>.<action>` — flat strings, not booleans.
 * The old schema's `is_view` / `is_edit` pair could not express
 * "may dispense but may not adjust stock", nor be scoped to a branch.
 */

export const MODULES = [
  'platform',
  'organization',
  'branch',
  'iam',
  'doctor',
  'patient',
  'appointment',
  'clinical',
  'lab',
  'product',
  'pharmacy',
  'inventory',
  'billing',
  'report',
  'settings',
  'audit',
] as const;

export type Module = (typeof MODULES)[number];

export const PERMISSIONS = {
  // -- platform (super admin only) -------------------------------------------
  PLATFORM_ORG_READ: 'platform.organization.read',
  PLATFORM_ORG_MANAGE: 'platform.organization.manage',
  PLATFORM_ORG_SUSPEND: 'platform.organization.suspend',
  PLATFORM_PLAN_MANAGE: 'platform.plan.manage',
  /**
   * Add, change and retire the jurisdictions rcln collects tax in.
   *
   * Separate from PLAN_MANAGE because it is a different kind of claim: a plan
   * price is a commercial decision, a tax registration asserts that we are
   * registered with a revenue authority. Getting the second one wrong collects
   * money from customers that cannot be remitted to anybody.
   */
  PLATFORM_TAX_MANAGE: 'platform.tax.manage',
  PLATFORM_SUBSCRIPTION_MANAGE: 'platform.subscription.manage',
  PLATFORM_IMPERSONATE: 'platform.impersonate',
  PLATFORM_AUDIT_READ: 'platform.audit.read',

  // -- organization ----------------------------------------------------------
  ORG_READ: 'organization.read',
  ORG_UPDATE: 'organization.update',
  ORG_BILLING_READ: 'organization.billing.read',
  ORG_BILLING_MANAGE: 'organization.billing.manage',

  // -- branch ----------------------------------------------------------------
  BRANCH_READ: 'branch.read',
  BRANCH_CREATE: 'branch.create',
  BRANCH_UPDATE: 'branch.update',
  BRANCH_DELETE: 'branch.delete',

  // -- iam -------------------------------------------------------------------
  IAM_USER_READ: 'iam.user.read',
  IAM_USER_INVITE: 'iam.user.invite',
  IAM_USER_UPDATE: 'iam.user.update',
  IAM_USER_SUSPEND: 'iam.user.suspend',
  IAM_ROLE_READ: 'iam.role.read',
  IAM_ROLE_MANAGE: 'iam.role.manage',
  IAM_PERMISSION_ASSIGN: 'iam.permission.assign',
  /**
   * Add and retire the job titles this clinic hands out.
   *
   * Separate from IAM_ROLE_MANAGE because it is a much smaller claim: a role
   * carries permissions, so editing one changes what people can DO. A
   * designation is a label — the front desk needs to add "Senior Consultant"
   * without also being able to grant permissions.
   *
   * READING the list is covered by IAM_USER_INVITE and IAM_USER_READ, because
   * the invite form has to render the menu.
   */
  IAM_DESIGNATION_MANAGE: 'iam.designation.manage',

  /*
   * -- doctor -----------------------------------------------------------------
   *
   * A doctor is a `users` row with a `doctor_profiles` row; practising at three
   * branches is three `membership_roles`. These codes govern the profile and the
   * working hours behind it — not the consultation, which is `clinical.*`.
   *
   * Editing your OWN profile is not a code. The service compares
   * `profile.userId` against `ctx.userId` and allows the bio/qualification
   * subset under DOCTOR_READ; a `doctor.self.update` code would be a claim the
   * permission resolver cannot scope to one row.
   */
  DOCTOR_READ: 'doctor.read',
  /**
   * Browse the roster — every practitioner at the clinic, as a list.
   *
   * ⚠️ SPLIT OUT OF DOCTOR_READ, AND THE SPLIT IS THE WHOLE DOCTORS TAB. Reading
   *   *a* profile and enumerating *all* of them are different acts. The front
   *   desk needs the roster: it books against it. A doctor does not — they need
   *   their own profile, which `GET /doctors/me` serves under DOCTOR_READ, and
   *   the colleague list is a personnel directory rather than a clinical tool.
   *
   *   This is what makes a doctor's navigation two tabs and the front desk's
   *   three, without either the nav or the API asking what role anyone holds.
   *   The alternative was a `if (role === 'DOCTOR')` in the header, which is
   *   exactly the role column ADR-0002 exists to keep out of the codebase.
   */
  DOCTOR_DIRECTORY_READ: 'doctor.directory.read',
  DOCTOR_CREATE: 'doctor.create',
  DOCTOR_UPDATE: 'doctor.update',
  DOCTOR_ARCHIVE: 'doctor.archive',
  DOCTOR_SCHEDULE_READ: 'doctor.schedule.read',
  DOCTOR_SCHEDULE_MANAGE: 'doctor.schedule.manage',
  /**
   * Ask for leave. Deliberately separate from DOCTOR_SCHEDULE_APPROVE: a doctor
   * requesting time off and a manager granting it are different claims. Fused
   * into one code, either doctors approve their own leave — and the availability
   * engine silently loses those days — or they cannot ask for it at all.
   */
  DOCTOR_SCHEDULE_REQUEST: 'doctor.schedule.request',
  DOCTOR_SCHEDULE_APPROVE: 'doctor.schedule.approve',
  /** Org-scoped specialties and qualifications. Platform rows are seeded. */
  DOCTOR_MASTER_MANAGE: 'doctor.master.manage',
  /**
   * What the clinic has agreed to pay a doctor, and over what interval.
   *
   * ⚠️ ITS OWN PAIR, AND EMPHATICALLY NOT `doctor.update`. Every BRANCH_ADMIN
   *   holds that one, so folding pay into it means whoever can fix a typo in a
   *   bio can read every colleague's salary. Nor is it
   *   `billing.doctor_payout.manage`, which was named for RUNNING payouts — a
   *   module that does not exist and stays in Phase 4. This records an agreed
   *   figure; it pays nobody.
   *
   * ⚠️ BRANCH_ADMIN IS DELIBERATELY EXCLUDED FROM BOTH. Pay is not a branch
   *   manager's business by default, and a clinic that disagrees grants the code
   *   on one membership. ACCOUNTANT holds the read — they already hold
   *   DOCTOR_PAYOUT_MANAGE and cannot pay a figure they cannot see — but not the
   *   manage: agreeing a salary is the owner's act, not the bookkeeper's.
   *
   * ⚠️ A DOCTOR READING THEIR OWN IS NOT THIS CODE. It is scoping, exactly like
   *   editing your own profile: the service compares `profile.userId` against
   *   `ctx.userId`, because the permission resolver grants across a branch scope
   *   and cannot express "this one row".
   */
  DOCTOR_COMPENSATION_READ: 'doctor.compensation.read',
  DOCTOR_COMPENSATION_MANAGE: 'doctor.compensation.manage',

  // -- patient ---------------------------------------------------------------
  PATIENT_READ: 'patient.read',
  PATIENT_CREATE: 'patient.create',
  PATIENT_UPDATE: 'patient.update',
  PATIENT_DELETE: 'patient.delete',
  PATIENT_MEDICAL_HISTORY_READ: 'patient.medical_history.read',
  PATIENT_MEDICAL_HISTORY_WRITE: 'patient.medical_history.write',
  PATIENT_DOCUMENT_READ: 'patient.document.read',
  PATIENT_DOCUMENT_UPLOAD: 'patient.document.upload',
  PATIENT_EXPORT: 'patient.export',

  // -- appointment -----------------------------------------------------------
  APPOINTMENT_READ: 'appointment.read',
  APPOINTMENT_CREATE: 'appointment.create',
  APPOINTMENT_UPDATE: 'appointment.update',
  APPOINTMENT_CANCEL: 'appointment.cancel',
  /**
   * Withdraw a booking that never happened, as opposed to cancelling one that
   * did and was called off.
   *
   * ⚠️ SEPARATE FROM APPOINTMENT_CANCEL ON PURPOSE. A cancellation is a clinical
   *   and commercial fact — it carries a reason, it appears in the no-show and
   *   utilisation reports, and a billing rule may act on it. A deletion asserts
   *   the booking should never have existed: the wrong patient, the wrong
   *   doctor, a double tap on the button. Folding the two into one code means
   *   the reports cannot tell "the patient called off" from "the receptionist
   *   mistyped", which are different numbers to a clinic.
   *
   *   The service narrows this further than the code can: only a FUTURE booking
   *   still in BOOKED may be deleted, so nothing that has been confirmed,
   *   attended or charted is reachable through it — and it is a soft delete, so
   *   even then the row survives for audit.
   */
  APPOINTMENT_DELETE: 'appointment.delete',
  APPOINTMENT_CHECKIN: 'appointment.checkin',
  QUEUE_MANAGE: 'appointment.queue.manage',
  /**
   * See which slots are free. Separate from DOCTOR_SCHEDULE_READ because a
   * patient on the portal must be able to book without reading the doctor's
   * schedule configuration — `max_patients`, validity windows, or the reason
   * attached to a day of leave.
   */
  APPOINTMENT_AVAILABILITY_READ: 'appointment.availability.read',

  // -- clinical --------------------------------------------------------------
  /**
   * Read the consultation: what the doctor concluded, and the chart it hangs on.
   *
   * ⚠️ READ IS NOT AUTHORSHIP, AND THE SPLIT BELOW IS THE POINT. An
   *   administrator running the clinic can open a consultation and read it —
   *   that is oversight, and the audit trail records it. They cannot write one.
   *   Diagnosing a patient is an act only a clinician performs, so
   *   `ENCOUNTER_CREATE`, `ENCOUNTER_CLOSE`, `PRESCRIPTION_CREATE` and
   *   `PRESCRIPTION_SIGN` are held by DOCTOR alone among the system roles, and
   *   are stripped from ORG_OWNER and ORG_ADMIN by name in `roles.ts`.
   */
  ENCOUNTER_READ: 'clinical.encounter.read',
  ENCOUNTER_CREATE: 'clinical.encounter.create',
  ENCOUNTER_CLOSE: 'clinical.encounter.close',
  /**
   * See the observations taken for a visit, and their correction history.
   *
   * ⚠️ SPLIT FROM `VITALS_RECORD` BECAUSE THE DOCTOR IS A READER HERE. This code
   *   used to gate the GETs as well, which meant the only way to let a doctor
   *   SEE a blood pressure was to let them type one in. A doctor consults; the
   *   cuff is on the arm at the front desk or in the nurse's room, and whoever
   *   put it there is who owns the number. So the doctor holds this and not
   *   `VITALS_RECORD` — they read the chart and cannot silently amend an
   *   observation somebody else is accountable for.
   */
  VITALS_READ: 'clinical.vitals.read',
  /**
   * Take an observation, correct one, or withdraw one.
   *
   * ⚠️ THE ONLY CLINICAL CODE THE FRONT DESK HOLDS, and a WRITE code with no
   *   read of its own — it implies `VITALS_READ` nowhere in the type system, so
   *   every role that records also carries the read code explicitly.
   */
  VITALS_RECORD: 'clinical.vitals.record',
  PRESCRIPTION_READ: 'clinical.prescription.read',
  PRESCRIPTION_CREATE: 'clinical.prescription.create',
  PRESCRIPTION_SIGN: 'clinical.prescription.sign',
  CLINICAL_MASTER_MANAGE: 'clinical.master.manage',

  // -- lab -------------------------------------------------------------------
  LAB_ORDER_READ: 'lab.order.read',
  LAB_ORDER_CREATE: 'lab.order.create',
  LAB_SAMPLE_COLLECT: 'lab.sample.collect',
  LAB_RESULT_ENTER: 'lab.result.enter',
  LAB_RESULT_VERIFY: 'lab.result.verify',
  LAB_REPORT_RELEASE: 'lab.report.release',
  LAB_MASTER_MANAGE: 'lab.master.manage',

  // -- product ---------------------------------------------------------------
  /*
   * The catalogue: what a thing IS. Gloves, implants, reagents, dental
   * materials and medicines, in one table (PI-ADR-001).
   *
   * ⚠️ A NEW MODULE RATHER THAN `pharmacy.medicine.*`, AND `pharmacy.medicine.*`
   *   IS KEPT (PI-ADR-011). The obvious move is to gate the catalogue behind the
   *   pharmacy codes that already exist — and it is wrong, because under
   *   PI-ADR-001 the catalogue is not a pharmacy concern. A dentist maintains
   *   dental materials and a lab manager maintains reagents; neither should need
   *   a permission that also lets them dispense a controlled drug.
   *
   *   So the split is: `product.definition.*` is the catalogue, and
   *   `pharmacy.medicine.*` narrows to the MEDICINE-SPECIFIC attributes —
   *   dosage form, route, release type, the prescription hint. A pharmacist
   *   holds both; a dental store manager holds only the first pair. Nothing is
   *   deleted and no grant is revoked, so this is additive and reversible.
   *
   * ⚠️ A PRODUCT'S TAX CLASSIFICATION IS NOT HERE. It is gated by
   *   `billing.tax.manage`, because deciding a product's tax category decides
   *   what every future patient is charged for it — the accountant's call, not
   *   the storekeeper's. The catalogue already draws this line for fee schedules
   *   and tax rules; see the route file.
   */
  PRODUCT_DEFINITION_READ: 'product.definition.read',
  PRODUCT_DEFINITION_MANAGE: 'product.definition.manage',
  /*
   * Separate from DEFINITION_MANAGE because it is a different kind of claim.
   * A name is a label; a GTIN is what a scanner resolves to a product, so a
   * wrong one silently dispenses the wrong medicine against a correct scan.
   * Whoever reconciles barcodes is not always whoever names things.
   */
  PRODUCT_IDENTIFIER_MANAGE: 'product.identifier.manage',

  // -- pharmacy --------------------------------------------------------------
  MEDICINE_READ: 'pharmacy.medicine.read',
  MEDICINE_MANAGE: 'pharmacy.medicine.manage',
  DISPENSE_READ: 'pharmacy.dispense.read',
  DISPENSE_CREATE: 'pharmacy.dispense.create',
  DISPENSE_RETURN: 'pharmacy.dispense.return',
  SUPPLIER_MANAGE: 'pharmacy.supplier.manage',
  PURCHASE_ORDER_READ: 'pharmacy.purchase_order.read',
  PURCHASE_ORDER_MANAGE: 'pharmacy.purchase_order.manage',
  GOODS_RECEIPT_MANAGE: 'pharmacy.goods_receipt.manage',

  // -- inventory -------------------------------------------------------------
  STOCK_READ: 'inventory.stock.read',
  STOCK_ADJUST: 'inventory.stock.adjust',
  STOCK_TRANSFER: 'inventory.stock.transfer',
  BATCH_MANAGE: 'inventory.batch.manage',

  // -- billing ---------------------------------------------------------------
  INVOICE_READ: 'billing.invoice.read',
  /*
   * Every invoice, whatever it bills for.
   *
   * ⚠️ THIS IS NOT "READ, BUT MORE". `INVOICE_READ` is the gate on the SURFACE —
   *   whether a caller may see the invoice module at all — and WHICH invoices
   *   they see is derived from the modules they work in: a pharmacist holding
   *   `pharmacy.dispense.read` sees pharmacy invoices, a lab assistant sees the
   *   lab's. That rule lives in `invoice-visibility.ts` and is applied in the
   *   QUERY, never in a filter the caller passes.
   *
   *   This code is the escape from it, for the roles whose job is the whole
   *   ledger — the accountant, the branch administrator. It is one code rather
   *   than `pharmacy.invoice.read` + `lab.invoice.read` + … precisely so that a
   *   source added later does not have to be re-granted to anybody.
   */
  INVOICE_READ_ALL: 'billing.invoice.read_all',
  INVOICE_CREATE: 'billing.invoice.create',
  INVOICE_UPDATE: 'billing.invoice.update',
  INVOICE_CANCEL: 'billing.invoice.cancel',
  /*
   * The clinic's own tax configuration: which registrations it holds, and what
   * it charges for each kind of item.
   *
   * ⚠️ NOT `settings.organization.*`, AND THE DIFFERENCE IS WHAT A WRONG VALUE
   *   COSTS. A setting is a preference — a clock format, a slot length — and the
   *   worst a bad one does is annoy somebody. A tax rule decides what every
   *   patient is charged and what the clinic owes the government: an EXEMPT
   *   consultation rated at 18% collects money nobody owed, and a 12% medicine
   *   rated at 0% leaves the clinic owing tax it never took. That is the
   *   accountant's job and the owner's, not whoever can change the clock.
   *
   * ⚠️ READ IS SEPARATE FROM MANAGE BECAUSE THE RATE CARD EXPLAINS AN INVOICE. A
   *   cashier looking at why a bill charged 5% needs to see the rule; letting
   *   them edit it would let a counter change the rate rather than query it.
   *
   * ⚠️ AND NEITHER OF THESE IS `platform.tax.manage`, which maintains
   *   `tax_rule_defaults` — the published law of a country, shared by every
   *   clinic in it. This pair only ever touches this organization's own rows.
   */
  BILLING_TAX_READ: 'billing.tax.read',
  BILLING_TAX_MANAGE: 'billing.tax.manage',
  /*
   * What the clinic charges for an appointment: the fee schedule, its clinic
   * defaults and its per-doctor overrides.
   *
   * ⚠️ NOT `billing.invoice.*`, AND NOT A SETTINGS CODE. An invoice code says
   *   what somebody may do with a bill that exists; this decides what every
   *   future bill SAYS, which is a different act with a different blast radius.
   *   And it is not `settings.organization.write` for the reason BILLING_TAX_*
   *   is not: a setting's worst failure is an annoyance, and a wrong fee is a
   *   patient charged the wrong amount at the desk.
   *
   * ⚠️ THE READ IS HELD WIDELY ON PURPOSE. The front desk is quoted the fee
   *   while it books (§0.2 decision 13), and a doctor may see their own rates —
   *   so receptionists, nurses, doctors and accountants all hold the read. A fee
   *   nobody can see until the invoice is a quote the patient was never given.
   *
   * ⚠️ THE MANAGE IS NOT ON BRANCH_ADMIN, mirroring BILLING_TAX_MANAGE. A price
   *   is a commercial position of the organization even when it varies by
   *   branch, so it lands on ORG_OWNER and ORG_ADMIN by their "everything
   *   except" definition and nowhere else. A clinic that wants its branch
   *   manager to set prices grants the code on that membership, which is a
   *   smaller decision than a role change.
   */
  FEE_SCHEDULE_READ: 'billing.fee_schedule.read',
  FEE_SCHEDULE_MANAGE: 'billing.fee_schedule.manage',
  PAYMENT_COLLECT: 'billing.payment.collect',
  CREDIT_NOTE_ISSUE: 'billing.credit_note.issue',
  REFUND_PROCESS: 'billing.refund.process',
  DOCTOR_PAYOUT_MANAGE: 'billing.doctor_payout.manage',

  // -- reports ---------------------------------------------------------------
  REPORT_DASHBOARD: 'report.dashboard.read',
  REPORT_REVENUE: 'report.revenue.read',
  REPORT_CLINICAL: 'report.clinical.read',
  REPORT_INVENTORY: 'report.inventory.read',
  REPORT_EXPORT: 'report.export',

  // -- settings --------------------------------------------------------------
  SETTINGS_ORG_READ: 'settings.organization.read',
  SETTINGS_ORG_WRITE: 'settings.organization.write',
  SETTINGS_BRANCH_READ: 'settings.branch.read',
  SETTINGS_BRANCH_WRITE: 'settings.branch.write',
  SETTINGS_USER_WRITE: 'settings.user.write',

  /*
   * -- audit ------------------------------------------------------------------
   *
   * Reading a record's own history: who changed it, what moved, and when. The
   * clinic's counterpart to `platform.audit.read`, which spans every tenant.
   *
   * THERE IS NO WRITE, AND NO DELETE. `audit_logs` is append-only, and that is
   * enforced by Postgres rather than by the absence of a code — `rcln_app` holds
   * no UPDATE or DELETE on the table (see the `audit_immutability` migration). A
   * permission to edit history would be a permission to make the trail lie.
   */
  AUDIT_READ: 'audit.record.read',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as PermissionCode[];

/** Split `pharmacy.dispense.create` into its module for grouping in the UI. */
export function moduleOf(code: PermissionCode): string {
  return code.split('.')[0] ?? 'unknown';
}
