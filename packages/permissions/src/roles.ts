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
  P.ENCOUNTER_AMEND,
  P.PRESCRIPTION_CREATE,
  P.PRESCRIPTION_SIGN,
];

const authorsClinicalNotes = (p: PermissionCode): boolean => CLINICAL_AUTHORING.includes(p);

/**
 * Signing off a jurisdiction's rule pack. NOT held by anybody, by default.
 *
 * ⚠️ NAMED HERE FOR THE SAME REASON `CLINICAL_AUTHORING` IS: ORG_OWNER and
 *   ORG_ADMIN are "everything except" roles, so a code added to this codebase
 *   joins them silently unless it is excluded by name. `regulatory.pack.approve`
 *   is the one code that must never arrive that way.
 *
 * PI-ADR-009: advancing a pack to `REGULATORY_REVIEWED` or `PRODUCTION_ENABLED`
 * is a statement that a jurisdiction's rules have been checked by somebody
 * qualified to check them. That is not a consequence of owning a clinic, and it
 * is emphatically not a consequence of writing the software: no migration, seed,
 * script or agent may set either state. The company grants this code to a named
 * person — counsel, a retained consultant, a registered pharmacist — deliberately
 * and out of band.
 *
 * ⚠️ SUPER_ADMIN KEEPS IT, because it is `ALL_PERMISSIONS` by definition and is
 *   the platform's break-glass account rather than a role anybody is assigned.
 *   That is the same carve-out `CLINICAL_AUTHORING` makes, and it is the one
 *   place the ladder rests on operational discipline rather than on code.
 */
const REGULATORY_SIGN_OFF: PermissionCode[] = [PERMISSIONS.REGULATORY_PACK_APPROVE];

const signsOffRulePacks = (p: PermissionCode): boolean => REGULATORY_SIGN_OFF.includes(p);

/**
 * Maintaining the LAW itself — jurisdictions, authorities, sources, packs, rules.
 *
 * ⚠️ EXCLUDED FROM THE TWO "EVERYTHING EXCEPT" ROLES BECAUSE IT IS A PLATFORM
 *   CODE WEARING A MODULE PREFIX. It gates rcln's own console over
 *   `regulatory_rule_packs`, whose rows are shared by every clinic on the
 *   platform; the `platform_law_not_tenant_writable` trigger refuses a write
 *   from any tenant transaction regardless, so granting it to a clinic owner
 *   would hand out a code that can never do anything — which reads in a review
 *   as a clinic being able to rewrite another clinic's rules.
 *
 *   It lives in the `regulatory` module rather than `platform` so that it sits
 *   beside the read it is the write half of; this filter is what keeps that
 *   naming choice from widening anybody's access.
 *
 * A clinic's own regulatory work is `product.regulatory.*`, which both roles do
 * keep: asserting what a product IS here is exactly a clinic's job.
 */
const maintainsPlatformLaw = (p: PermissionCode): boolean => p === PERMISSIONS.REGULATORY_MANAGE;

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
    /*
     * Everything except platform-level permissions, authoring a consultation,
     * and signing off a regulatory rule pack.
     */
    permissions: ALL_PERMISSIONS.filter(
      (p) =>
        !p.startsWith('platform.') &&
        !authorsClinicalNotes(p) &&
        !signsOffRulePacks(p) &&
        !maintainsPlatformLaw(p)
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
        !signsOffRulePacks(p) &&
        !maintainsPlatformLaw(p) &&
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
      /*
       * Reads the jurisdiction's rules and records a product's regulatory
       * position, like the pharmacist below (PI-5) — a branch administrator runs
       * the store at sites that have no pharmacist at all.
       */
      P.REGULATORY_READ,
      P.PRODUCT_REGULATORY_READ,
      P.PRODUCT_REGULATORY_MANAGE,
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
      /*
       * Both halves of the requisition split (PI-4.3), and this is the ONE
       * BRANCH-LEVEL ROLE THAT HOLDS BOTH.
       *
       * ⚠️ HOLDING BOTH IS NOT SELF-APPROVAL. The
       *   `purchase_requisitions_approver_is_not_creator` CHECK compares the two
       *   USER IDS on the row, not the two permissions on the role — so a branch
       *   administrator approves what their storekeeper raised and cannot approve
       *   their own. Which is the realistic shape of a small clinic: the person
       *   who runs the site signs off what the dispensary asked for.
       */
      P.REQUISITION_CREATE,
      P.REQUISITION_APPROVE,
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
       * Corrects a signed record by writing a new one that cites it (CE-3). The
       * doctor who signed it is who restates it — an amendment carries the same
       * clinical accountability as the original, which is why it is authoring
       * and not administration.
       */
      P.ENCOUNTER_AMEND,
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
      /*
       * Reads what a jurisdiction says about what they are about to prescribe,
       * and asserts nothing (PI-5). The same line invariant 7 draws for the
       * catalogue: consulting the rule is prescribing, recording the product's
       * regulatory position is storekeeping.
       */
      P.REGULATORY_READ,
      P.PRODUCT_REGULATORY_READ,
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
      /*
       * And its regulatory position (PI-5), for the same reason the catalogue
       * codes are here rather than the pharmacy ones: a reagent is imported
       * under a licence and a diagnostic kit is a registered device. Regulation
       * is not a pharmacy concern (PI-ADR-001), so a lab manager records the
       * lab's own without needing a code that also dispenses medicines.
       */
      P.REGULATORY_READ,
      P.PRODUCT_REGULATORY_READ,
      P.PRODUCT_REGULATORY_MANAGE,
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
      /*
       * The regulatory side of the same product (PI-5): reads the jurisdiction's
       * rules, and records what the product IS here — its registration, its
       * classification, its schedule.
       *
       * ⚠️ THE ONE ROLE THAT HOLDS THE ASSERT WITHOUT A SECOND THOUGHT, because
       *   it is the role that will be REFUSED by these rules. A pharmacist who
       *   cannot read the rule that blocked a dispense cannot explain it to the
       *   patient standing at the counter, and one who cannot record that a
       *   product is Schedule H is a pharmacist waiting for an administrator to
       *   do it for them.
       *
       * ⚠️ NEITHER OF THESE WRITES A RULE. `regulatory.rule.manage` is rcln's,
       *   and the database refuses a tenant write to a rule pack regardless.
       */
      P.REGULATORY_READ,
      P.PRODUCT_REGULATORY_READ,
      P.PRODUCT_REGULATORY_MANAGE,
      P.DISPENSE_READ,
      /*
       * Verifying a prescription and supplying against it (PI-7). Both, on this
       * role, because a dispensary with one pharmacist is the ordinary shape and
       * a split that made single-pharmacist clinics unusable would be a control
       * on paper only. See the codes file for what the split buys a clinic that
       * does separate them.
       *
       * ⚠️ NO ROLE BUT THIS ONE STARTS WITH `.create`, INCLUDING DOCTOR — and
       *   that is a default rather than a position on who may lawfully dispense.
       *   Several jurisdictions expressly permit a practitioner to dispense to
       *   their own patients (India's Pharmacy Act s. 42(1) says so in the
       *   section itself, and the regulatory engine models the proviso). A
       *   clinic where the doctor runs the dispensary grants these by cloning a
       *   role or per membership; handing every DOCTOR the supply codes by
       *   default would be this platform deciding a clinic's staffing for it.
       */
      P.DISPENSE_VERIFY,
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
      /*
       * Raises requisitions and deliberately does NOT approve them (PI-4.3).
       *
       * ⚠️ THE ASYMMETRY IS THE CONTROL. A pharmacist knows what the dispensary
       *   is running out of, which is exactly why they should be the one asking —
       *   and exactly why somebody else should be the one agreeing to spend the
       *   money. `BRANCH_ADMIN` holds the approve half.
       *
       * ⚠️ THEY DO ALREADY HOLD `pharmacy.purchase_order.manage`, WHICH IS
       *   STRICTLY STRONGER, AND THAT PREDATES THIS SPLIT. A pharmacist can
       *   therefore commit the clinic's money by raising a PO directly, with no
       *   requisition and nobody's approval. It is not widened here and it is not
       *   silently narrowed either — revoking a code every existing clinic
       *   already holds is the one thing a permission change must not do quietly.
       *   Recorded in KNOWN_ISSUES for a clinic to narrow with a cloned role.
       */
      P.REQUISITION_CREATE,
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
