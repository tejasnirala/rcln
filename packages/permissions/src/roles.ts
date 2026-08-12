import { ALL_PERMISSIONS, PERMISSIONS, type PermissionCode } from './codes.js';

/**
 * System role definitions, seeded once with `organizationId = null`.
 * Tenants never mutate these — they clone one into a custom org-scoped role.
 */

export const SYSTEM_ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ORG_OWNER: 'ORG_OWNER',
  ORG_ADMIN: 'ORG_ADMIN',
  BRANCH_ADMIN: 'BRANCH_ADMIN',
  DOCTOR: 'DOCTOR',
  NURSE: 'NURSE',
  RECEPTIONIST: 'RECEPTIONIST',
  LAB_ASSISTANT: 'LAB_ASSISTANT',
  LAB_MANAGER: 'LAB_MANAGER',
  PHARMACIST: 'PHARMACIST',
  ACCOUNTANT: 'ACCOUNTANT',
  PATIENT: 'PATIENT',
} as const;

export type SystemRoleCode = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

export type RoleScopeLevel = 'PLATFORM' | 'ORGANIZATION' | 'BRANCH';

export interface SystemRoleDefinition {
  code: SystemRoleCode;
  name: string;
  description: string;
  scopeLevel: RoleScopeLevel;
  permissions: PermissionCode[];
}

const P = PERMISSIONS;

/**
 * Writing up a consultation. NOT reading one.
 *
 * ⚠️ ORG_OWNER AND ORG_ADMIN ARE "EVERYTHING EXCEPT…" ROLES, SO A NEW AUTHORING
 *   CODE JOINS THEM BY DEFAULT UNLESS IT IS NAMED HERE. Diagnosing a patient,
 *   closing an encounter and signing a prescription are acts a clinician
 *   performs and signs their name to. An administrator has every reason to READ
 *   what was written — that is oversight, and it lands in the audit trail — and
 *   no business authoring it. Running the clinic is not practising in it.
 *
 * ⚠️ THIS IS A DEFAULT, NOT A CEILING. A clinic that wants a doctor's assistant
 *   or associate to write up the consultation clones DOCTOR into an org-scoped
 *   role, names it whatever the clinic calls that job, and keeps these codes on
 *   it — or grants them to one person through the per-membership override. That
 *   path is deliberately open: this list decides what a role starts with, and
 *   never what a clinic is allowed to decide.
 *
 * SUPER_ADMIN keeps them: it is `ALL_PERMISSIONS` by definition and it is the
 * platform's break-glass account, not a role anybody at a clinic is assigned.
 */
const CLINICAL_AUTHORING: PermissionCode[] = [
  P.ENCOUNTER_CREATE,
  P.ENCOUNTER_CLOSE,
  P.PRESCRIPTION_CREATE,
  P.PRESCRIPTION_SIGN,
];

const authorsClinicalNotes = (p: PermissionCode): boolean => CLINICAL_AUTHORING.includes(p);

export const SYSTEM_ROLE_DEFINITIONS: SystemRoleDefinition[] = [
  {
    code: SYSTEM_ROLES.SUPER_ADMIN,
    name: 'Super Admin',
    description: 'Platform operator. Seeded directly into the database, never created via the UI.',
    scopeLevel: 'PLATFORM',
    permissions: ALL_PERMISSIONS,
  },
  {
    code: SYSTEM_ROLES.ORG_OWNER,
    name: 'Organization Owner',
    description: 'Registered the clinic. Full control including subscription and billing.',
    scopeLevel: 'ORGANIZATION',
    // Everything except platform-level permissions and authoring a consultation.
    permissions: ALL_PERMISSIONS.filter(
      (p) => !p.startsWith('platform.') && !authorsClinicalNotes(p)
    ),
  },
  {
    code: SYSTEM_ROLES.ORG_ADMIN,
    name: 'Organization Admin',
    description: 'Manages every branch, but cannot change the subscription or delete the org.',
    scopeLevel: 'ORGANIZATION',
    permissions: ALL_PERMISSIONS.filter(
      (p) =>
        !p.startsWith('platform.') &&
        !authorsClinicalNotes(p) &&
        p !== P.ORG_BILLING_MANAGE &&
        p !== P.BRANCH_DELETE &&
        p !== P.PATIENT_DELETE &&
        p !== P.DOCTOR_ARCHIVE
    ),
  },
  {
    code: SYSTEM_ROLES.BRANCH_ADMIN,
    name: 'Branch Admin',
    description:
      'Runs one or more branches. Which branches is decided per assignment in membership_roles, not here.',
    scopeLevel: 'BRANCH',
    permissions: [
      P.BRANCH_READ,
      P.BRANCH_UPDATE,
      P.IAM_USER_READ,
      P.IAM_USER_INVITE,
      P.IAM_USER_UPDATE,
      P.IAM_ROLE_READ,
      // Adding a job title is a label, not a permission grant — see the code.
      P.IAM_DESIGNATION_MANAGE,
      /*
       * Onboards doctors and owns their working hours — but not DOCTOR_ARCHIVE,
       * which retires a practitioner and with them the history hanging off their
       * profile. That stays with the owner, alongside PATIENT_DELETE.
       */
      P.DOCTOR_READ,
      P.DOCTOR_DIRECTORY_READ,
      P.DOCTOR_CREATE,
      P.DOCTOR_UPDATE,
      P.DOCTOR_SCHEDULE_READ,
      P.DOCTOR_SCHEDULE_MANAGE,
      P.DOCTOR_SCHEDULE_APPROVE,
      P.DOCTOR_MASTER_MANAGE,
      P.PATIENT_READ,
      P.PATIENT_CREATE,
      P.PATIENT_UPDATE,
      P.PATIENT_MEDICAL_HISTORY_READ,
      P.PATIENT_DOCUMENT_READ,
      P.APPOINTMENT_READ,
      P.APPOINTMENT_CREATE,
      P.APPOINTMENT_UPDATE,
      P.APPOINTMENT_CANCEL,
      P.APPOINTMENT_DELETE,
      P.APPOINTMENT_CHECKIN,
      P.APPOINTMENT_AVAILABILITY_READ,
      P.QUEUE_MANAGE,
      /*
       * Reads the clinical record and cannot author it — see CLINICAL_AUTHORING.
       * `VITALS_READ` without `VITALS_RECORD` for the same reason: a branch
       * administrator checks that the observations were taken, they do not take
       * them.
       */
      P.ENCOUNTER_READ,
      P.VITALS_READ,
      P.PRESCRIPTION_READ,
      P.LAB_ORDER_READ,
      P.LAB_MASTER_MANAGE,
      /*
       * Runs the store as well as the branch: the catalogue and the barcodes on
       * it. Paired with STOCK_ADJUST and BATCH_MANAGE below, which are useless
       * without knowing what the stock IS.
       */
      P.PRODUCT_DEFINITION_READ,
      P.PRODUCT_DEFINITION_MANAGE,
      P.PRODUCT_IDENTIFIER_MANAGE,
      P.MEDICINE_READ,
      P.MEDICINE_MANAGE,
      P.DISPENSE_READ,
      P.SUPPLIER_MANAGE,
      P.PURCHASE_ORDER_READ,
      P.PURCHASE_ORDER_MANAGE,
      P.GOODS_RECEIPT_MANAGE,
      P.STOCK_READ,
      P.STOCK_ADJUST,
      P.STOCK_TRANSFER,
      /*
       * Holds stock back and gives it back (PI-3.4). Weaker than STOCK_ADJUST —
       * it changes which bucket a quantity sits in, never how much there is —
       * and granted here because both of these roles run a store where somebody
       * says "keep that for Mrs Rao's procedure on Thursday".
       */
      P.STOCK_RESERVE,
      P.BATCH_MANAGE,
      /*
       * Defines the shelves as well as counting what is on them. Both roles
       * that hold this run a physical store — a branch administrator for the
       * site, a pharmacist for the dispensary — and a store whose fridge and
       * controlled cabinet cannot be created is a store that records everything
       * as being in one undifferentiated place. See PI-ADR-012.
       */
      P.INVENTORY_LOCATION_MANAGE,
      /*
       * And the vocabulary the adjustments are filed under (PI-3.1). Same class
       * of decision as defining the shelves: taken once, by whoever runs the
       * store, and it decides what every future shrinkage report can aggregate.
       */
      P.INVENTORY_REASON_CODE_MANAGE,
      P.INVOICE_READ,
      /*
       * The whole ledger for the branches they run. A branch administrator
       * reconciling the day's takings cannot do it from the invoices of one
       * module — and see INVOICE_READ_ALL's own comment for why this is a single
       * escape rather than a grant per source.
       */
      P.INVOICE_READ_ALL,
      P.INVOICE_CREATE,
      P.INVOICE_UPDATE,
      P.INVOICE_CANCEL,
      /*
       * Read, and not manage. The rate card is what explains a bill their
       * counter raised, so they can look it up; a rate is an organization-wide
       * legal position, so they cannot change it. See BILLING_TAX_MANAGE.
       */
      P.BILLING_TAX_READ,
      /*
       * Reads the fee grid and does not set it, for the same reason as the tax
       * card immediately above — and see FEE_SCHEDULE_MANAGE's own note. A
       * branch administrator explaining "why was this patient charged 800?"
       * needs the grid; deciding that it is 800 is the organization's call.
       *
       * ⚠️ NO DOCTOR_COMPENSATION_READ EITHER, and that omission is deliberate:
       *   whoever can fix a typo in a bio must not thereby read the payroll.
       */
      P.FEE_SCHEDULE_READ,
      P.PAYMENT_COLLECT,
      P.CREDIT_NOTE_ISSUE,
      P.REFUND_PROCESS,
      P.DOCTOR_PAYOUT_MANAGE,
      P.REPORT_DASHBOARD,
      P.REPORT_REVENUE,
      P.REPORT_CLINICAL,
      P.REPORT_INVENTORY,
      P.REPORT_EXPORT,
      P.SETTINGS_BRANCH_READ,
      P.SETTINGS_BRANCH_WRITE,
      P.SETTINGS_USER_WRITE,
      /*
       * History on the records they manage. Deliberately NOT given to the
       * clinical and front-desk roles below: the trail names who suspended whom
       * and whose permissions changed, which is a manager's business rather than
       * everyone's. A clinic that wants a specific person to see it can grant
       * this code to them directly — that is what the per-person override
       * mechanism is for, and it is a smaller decision than a role change.
       */
      P.AUDIT_READ,
    ],
  },
  {
    code: SYSTEM_ROLES.DOCTOR,
    name: 'Doctor',
    description: 'Consults patients. Scoped to the branches they practise at.',
    scopeLevel: 'BRANCH',
    permissions: [
      /*
       * Reads their own profile and working hours, and ASKS for leave — but
       * cannot approve it, nor edit the schedule that decides when the clinic
       * can book them. Editing their own bio and qualifications is allowed under
       * DOCTOR_READ by an ownership check in the service, not by a code.
       *
       * ⚠️ NO DOCTOR_DIRECTORY_READ, DELIBERATELY. This is the one omission that
       *   makes a doctor's navigation two tabs — Appointments and Patients — and
       *   it is a real access decision, not a UI preference: the colleague
       *   roster is a personnel list, and `GET /doctors` refuses it here too.
       *   Their own profile comes from `GET /doctors/me` under DOCTOR_READ.
       */
      P.DOCTOR_READ,
      P.DOCTOR_SCHEDULE_READ,
      P.DOCTOR_SCHEDULE_REQUEST,
      P.APPOINTMENT_AVAILABILITY_READ,
      P.PATIENT_READ,
      P.PATIENT_CREATE,
      P.PATIENT_UPDATE,
      P.PATIENT_MEDICAL_HISTORY_READ,
      P.PATIENT_MEDICAL_HISTORY_WRITE,
      P.PATIENT_DOCUMENT_READ,
      P.PATIENT_DOCUMENT_UPLOAD,
      P.APPOINTMENT_READ,
      P.APPOINTMENT_CREATE,
      P.APPOINTMENT_UPDATE,
      P.APPOINTMENT_CANCEL,
      P.ENCOUNTER_READ,
      P.ENCOUNTER_CREATE,
      P.ENCOUNTER_CLOSE,
      /*
       * ⚠️ READS VITALS, DOES NOT RECORD THEM — the one clinical code a doctor
       *   deliberately lacks, and the only role in this file that reads without
       *   being able to write. A consultation is what a doctor is for; the cuff
       *   and the scales belong to whoever is standing with the patient before
       *   they come in, which is the front desk or the nurse. Giving the doctor
       *   `VITALS_RECORD` too would let a consultation quietly amend an
       *   observation somebody else is accountable for, and the chart would no
       *   longer say who measured what.
       *
       *   A clinic where the doctor genuinely does take the readings — a
       *   single-handed practice with no front desk — grants `VITALS_RECORD` to
       *   that person through the per-membership override, or onto its own
       *   clone of this role. That is a clinic's decision to make explicitly.
       */
      P.VITALS_READ,
      P.PRESCRIPTION_READ,
      P.PRESCRIPTION_CREATE,
      P.PRESCRIPTION_SIGN,
      P.LAB_ORDER_READ,
      P.LAB_ORDER_CREATE,
      /*
       * READ AND NOT MANAGE, which is the same line invariant 7 draws elsewhere:
       * a prescriber has to look up what they are prescribing, and curating the
       * clinic's catalogue is a storekeeping job. Pairs with the MEDICINE_READ
       * immediately below, which is what surfaces dosage form and route.
       */
      P.PRODUCT_DEFINITION_READ,
      P.MEDICINE_READ,
      P.INVOICE_READ,
      /*
       * Sees what the clinic charges for their own consultations, and cannot
       * change it — §0.2 decision 5. The read is org-wide rather than
       * self-scoped, like every other code here: the grid names fee types,
       * branches and amounts, which is commercial rather than personal. Their
       * own SALARY is a different matter and a different pair; see
       * DOCTOR_COMPENSATION_READ, which this role deliberately does not hold —
       * a doctor reads their own pay by ownership, not by a code.
       */
      P.FEE_SCHEDULE_READ,
      P.REPORT_DASHBOARD,
      P.REPORT_CLINICAL,
      P.SETTINGS_USER_WRITE,
    ],
  },
  {
    code: SYSTEM_ROLES.NURSE,
    name: 'Nurse',
    description: 'Records vitals, assists the encounter, manages the queue.',
    scopeLevel: 'BRANCH',
    permissions: [
      P.PATIENT_READ,
      P.PATIENT_UPDATE,
      P.PATIENT_MEDICAL_HISTORY_READ,
      P.DOCTOR_READ,
      /* Works alongside the whole roster and needs to see who is on today. */
      P.DOCTOR_DIRECTORY_READ,
      P.DOCTOR_SCHEDULE_READ,
      P.APPOINTMENT_READ,
      P.APPOINTMENT_CHECKIN,
      P.APPOINTMENT_AVAILABILITY_READ,
      P.QUEUE_MANAGE,
      P.ENCOUNTER_READ,
      /* Takes the observation AND reads it back — both codes, explicitly. */
      P.VITALS_READ,
      P.VITALS_RECORD,
      P.PRESCRIPTION_READ,
      P.LAB_ORDER_READ,
      /*
       * Reads the catalogue because a nurse draws consumables from the trolley
       * and will record what was used once PI-9 lands. Curating it is not their
       * job and neither is the medicine detail behind it — no MEDICINE_READ.
       */
      P.PRODUCT_DEFINITION_READ,
      P.SETTINGS_USER_WRITE,
    ],
  },
  {
    code: SYSTEM_ROLES.RECEPTIONIST,
    name: 'Receptionist / Front Desk',
    description: 'Registers patients, books appointments, collects payment. No clinical access.',
    scopeLevel: 'BRANCH',
    permissions: [
      P.PATIENT_READ,
      P.PATIENT_CREATE,
      P.PATIENT_UPDATE,
      /*
       * The front desk books, so it must see who is available and when — but the
       * schedule itself is read-only to it and the doctor's profile is not
       * editable from here.
       */
      P.DOCTOR_READ,
      /* The Doctors tab. Booking is choosing a practitioner from the roster. */
      P.DOCTOR_DIRECTORY_READ,
      P.DOCTOR_SCHEDULE_READ,
      P.APPOINTMENT_READ,
      P.APPOINTMENT_CREATE,
      P.APPOINTMENT_UPDATE,
      P.APPOINTMENT_CANCEL,
      /*
       * Withdrawing a mistyped booking is the front desk's own mistake to undo,
       * and the service will only let it touch a future one still in BOOKED.
       */
      P.APPOINTMENT_DELETE,
      P.APPOINTMENT_CHECKIN,
      P.APPOINTMENT_AVAILABILITY_READ,
      P.QUEUE_MANAGE,
      /*
       * ⚠️ THE ONLY CLINICAL CODES THE FRONT DESK HOLDS, and the role description
       *   above says "no clinical access" for everything else. Height, weight,
       *   temperature and blood pressure are taken at the desk before the
       *   patient is handed over — that is who is standing there with the cuff,
       *   and it is why THIS role owns the observations and the doctor's does
       *   not. It does NOT carry ENCOUNTER_READ or PRESCRIPTION_READ: the front
       *   desk writes observations and cannot read back what the doctor
       *   concluded from them.
       */
      P.VITALS_READ,
      P.VITALS_RECORD,
      /*
       * ⚠️ THE FEE IS QUOTED AT THIS DESK, which is why the front desk holds the
       *   read (§0.2 decision 13). The booking form shows what the visit will
       *   cost as the doctor and visit type are chosen, and the number it shows
       *   is the number frozen onto the appointment. A receptionist who cannot
       *   read the grid books a price the patient is told at the till instead.
       */
      P.FEE_SCHEDULE_READ,
      P.INVOICE_READ,
      P.INVOICE_CREATE,
      P.PAYMENT_COLLECT,
      P.REPORT_DASHBOARD,
      P.SETTINGS_USER_WRITE,
    ],
  },
  {
    code: SYSTEM_ROLES.LAB_ASSISTANT,
    name: 'Lab Assistant',
    description: 'Collects samples and enters results. Cannot verify or release a report.',
    scopeLevel: 'BRANCH',
    permissions: [
      P.PATIENT_READ,
      /** Reads which doctor ordered the test. No schedule, no availability. */
      P.DOCTOR_READ,
      P.LAB_ORDER_READ,
      P.LAB_SAMPLE_COLLECT,
      P.LAB_RESULT_ENTER,
      P.SETTINGS_USER_WRITE,
    ],
  },
  {
    code: SYSTEM_ROLES.LAB_MANAGER,
    name: 'Lab Manager',
    description: 'Verifies results and releases reports. Separation of duty from the assistant.',
    scopeLevel: 'BRANCH',
    permissions: [
      P.PATIENT_READ,
      P.DOCTOR_READ,
      P.LAB_ORDER_READ,
      P.LAB_ORDER_CREATE,
      P.LAB_SAMPLE_COLLECT,
      P.LAB_RESULT_ENTER,
      P.LAB_RESULT_VERIFY,
      P.LAB_REPORT_RELEASE,
      P.LAB_MASTER_MANAGE,
      /*
       * Reagents and diagnostic kits are products in the same catalogue as
       * medicines (PI-ADR-001), so the lab maintains its own consumables here.
       *
       * ⚠️ NO `pharmacy.medicine.*`, AND THAT IS THE POINT OF THE SPLIT. A lab
       *   manager names a reagent and never touches a dosage form or a
       *   prescription classification. Gating the catalogue behind the pharmacy
       *   codes — the obvious shortcut — would have handed exactly that here.
       */
      P.PRODUCT_DEFINITION_READ,
      P.PRODUCT_DEFINITION_MANAGE,
      P.PRODUCT_IDENTIFIER_MANAGE,
      P.INVOICE_READ,
      P.REPORT_DASHBOARD,
      P.SETTINGS_USER_WRITE,
    ],
  },
  {
    code: SYSTEM_ROLES.PHARMACIST,
    name: 'Pharmacist',
    description: 'Dispenses against prescriptions and manages stock.',
    scopeLevel: 'BRANCH',
    permissions: [
      P.PATIENT_READ,
      /** Reads the prescriber's name off a prescription. Nothing further. */
      P.DOCTOR_READ,
      P.PRESCRIPTION_READ,
      /*
       * Both halves of the split (PI-ADR-011): the catalogue, AND the
       * medicine-specific attributes on top of it. A pharmacist is the one role
       * that legitimately holds every one of these — they name the product, they
       * reconcile its barcode, and they set its dosage form.
       */
      P.PRODUCT_DEFINITION_READ,
      P.PRODUCT_DEFINITION_MANAGE,
      P.PRODUCT_IDENTIFIER_MANAGE,
      P.MEDICINE_READ,
      P.MEDICINE_MANAGE,
      P.DISPENSE_READ,
      P.DISPENSE_CREATE,
      P.DISPENSE_RETURN,
      P.SUPPLIER_MANAGE,
      P.PURCHASE_ORDER_READ,
      P.PURCHASE_ORDER_MANAGE,
      P.GOODS_RECEIPT_MANAGE,
      P.STOCK_READ,
      P.STOCK_ADJUST,
      P.STOCK_TRANSFER,
      /*
       * Holds stock back and gives it back (PI-3.4). Weaker than STOCK_ADJUST —
       * it changes which bucket a quantity sits in, never how much there is —
       * and granted here because both of these roles run a store where somebody
       * says "keep that for Mrs Rao's procedure on Thursday".
       */
      P.STOCK_RESERVE,
      P.BATCH_MANAGE,
      /*
       * Defines the shelves as well as counting what is on them. Both roles
       * that hold this run a physical store — a branch administrator for the
       * site, a pharmacist for the dispensary — and a store whose fridge and
       * controlled cabinet cannot be created is a store that records everything
       * as being in one undifferentiated place. See PI-ADR-012.
       */
      P.INVENTORY_LOCATION_MANAGE,
      /*
       * And the vocabulary the adjustments are filed under (PI-3.1). Same class
       * of decision as defining the shelves: taken once, by whoever runs the
       * store, and it decides what every future shrinkage report can aggregate.
       */
      P.INVENTORY_REASON_CODE_MANAGE,
      P.INVOICE_READ,
      P.INVOICE_CREATE,
      P.PAYMENT_COLLECT,
      P.REPORT_INVENTORY,
      P.SETTINGS_USER_WRITE,
    ],
  },
  {
    code: SYSTEM_ROLES.ACCOUNTANT,
    name: 'Accountant',
    description: 'Billing and revenue. Reads patient identity only, never clinical notes.',
    scopeLevel: 'ORGANIZATION',
    permissions: [
      P.PATIENT_READ,
      /** Doctor payouts are computed per practitioner, so identity is needed. */
      P.DOCTOR_READ,
      P.APPOINTMENT_READ,
      P.INVOICE_READ,
      /** Billing IS the job. Every invoice the organization raises, everywhere. */
      P.INVOICE_READ_ALL,
      P.INVOICE_CREATE,
      P.INVOICE_UPDATE,
      P.INVOICE_CANCEL,
      /*
       * The rate card is the accountant's, and they are the only role besides
       * the two "everything except" ones that gets to change it. A branch
       * administrator reads it — it explains a bill their counter raised — and
       * does not set it: a rate is an organization-wide legal position, and a
       * per-branch override of one is how two branches under one registration
       * start filing different returns.
       */
      P.BILLING_TAX_READ,
      P.BILLING_TAX_MANAGE,
      /*
       * ⚠️ READ ONLY, AND IT IS NOT DECORATION — WITHOUT IT `BILLING_TAX_MANAGE`
       *   IS UNUSABLE ON A PRODUCT. Setting a product's tax category is the
       *   accountant's decision and is gated by the code above, but the screen
       *   it happens on is the product screen, and that screen is behind this
       *   code. Granting the manage half without the read half produces a
       *   permission that exists and cannot be reached.
       *
       *   Still no MANAGE: naming and classifying the clinic's stock is
       *   storekeeping, and an accountant who could rename a product could
       *   change what a past invoice appears to have been for.
       */
      P.PRODUCT_DEFINITION_READ,
      /*
       * Reads the fee grid — it is what reconciles a consultation line against
       * what the clinic meant to charge — and does not set it. Unlike the tax
       * card, a fee is a commercial decision rather than a legal one, and the
       * organization takes it; see FEE_SCHEDULE_MANAGE.
       */
      P.FEE_SCHEDULE_READ,
      P.PAYMENT_COLLECT,
      P.CREDIT_NOTE_ISSUE,
      P.REFUND_PROCESS,
      P.DOCTOR_PAYOUT_MANAGE,
      /*
       * Reads what each doctor is paid, and does not agree it. They already hold
       * DOCTOR_PAYOUT_MANAGE and cannot pay a figure they cannot see; setting
       * the figure is the employment decision, which stays with the owner.
       */
      P.DOCTOR_COMPENSATION_READ,
      P.REPORT_DASHBOARD,
      P.REPORT_REVENUE,
      P.REPORT_EXPORT,
      P.ORG_BILLING_READ,
      P.SETTINGS_USER_WRITE,
    ],
  },
  {
    code: SYSTEM_ROLES.PATIENT,
    name: 'Patient',
    description:
      'Portal access to their own records only. Row filtering is by patient_id, not by this role.',
    scopeLevel: 'ORGANIZATION',
    permissions: [
      P.PATIENT_READ,
      /*
       * Sees who they can book with and which slots are free — but NOT
       * DOCTOR_SCHEDULE_READ, which would expose the schedule configuration
       * behind those slots: validity windows, per-block caps, and the reason
       * recorded against a day of leave.
       */
      P.DOCTOR_READ,
      P.APPOINTMENT_AVAILABILITY_READ,
      P.APPOINTMENT_READ,
      P.APPOINTMENT_CREATE,
      P.APPOINTMENT_CANCEL,
      P.PRESCRIPTION_READ,
      P.LAB_ORDER_READ,
      P.INVOICE_READ,
      P.PATIENT_DOCUMENT_READ,
      P.SETTINGS_USER_WRITE,
    ],
  },
];
