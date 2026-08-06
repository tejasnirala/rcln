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
  'patient',
  'appointment',
  'clinical',
  'lab',
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
  APPOINTMENT_CHECKIN: 'appointment.checkin',
  QUEUE_MANAGE: 'appointment.queue.manage',

  // -- clinical --------------------------------------------------------------
  ENCOUNTER_READ: 'clinical.encounter.read',
  ENCOUNTER_CREATE: 'clinical.encounter.create',
  ENCOUNTER_CLOSE: 'clinical.encounter.close',
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
  INVOICE_CREATE: 'billing.invoice.create',
  INVOICE_UPDATE: 'billing.invoice.update',
  INVOICE_CANCEL: 'billing.invoice.cancel',
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
