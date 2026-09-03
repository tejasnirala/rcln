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
  'regulatory',
  /*
   * ⚠️ ITS OWN MODULE RATHER THAN `inventory.*` (PI-10), and the reason is the
   *   one `consumption` gives. A recall is not a stock operation that happens to
   *   be urgent: it reaches across every branch at once, it blocks dispensing,
   *   and its second half is a list of NAMED PEOPLE who already received the
   *   product. Filing it under `inventory` would mean the code that lets a
   *   storekeeper count a shelf is adjacent to the code that answers "which of
   *   our patients has this implant".
   */
  'recall',
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
  /*
   * The onboarding wizard (CO-1).
   *
   * ⚠️ ORG-WIDE, NOT BRANCH-SCOPED, EVEN THOUGH THE WIZARD CAN WRITE A BRANCH
   *   OVERRIDE. Deciding that the satellite runs a pharmacy is the
   *   ORGANIZATION's decision about one of its sites, not a decision delegated
   *   to whoever runs that site. The `branchId` travels in the request body and
   *   is checked against the caller's own branches in the service.
   *
   * ⚠️ AND WRITE IS WHAT THE SHELL GATES ITS REDIRECT ON. A caller who holds it
   *   is sent to the wizard until setup is finished; everyone else gets a
   *   banner. Gating on the CODE rather than on ORG_OWNER is ADR-0002 — no role
   *   is named anywhere — and it means a clinic that clones a role to delegate
   *   setup gets the redirect too, which is what they asked for by cloning it.
   */
  ORG_ONBOARDING_READ: 'organization.onboarding.read',
  ORG_ONBOARDING_WRITE: 'organization.onboarding.write',

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
   * Correct a consultation that has already been finalized (CE-3, CD-2).
   *
   * ⚠️ AMENDING IS NOT EDITING, AND THIS CODE UNLOCKS NOTHING IN PLACE. A
   *   finalized record is immutable; an amendment is a NEW encounter that cites
   *   the one it corrects, states a reason, and is signed in its own right. What
   *   this code permits is starting that second record — which is why it sits in
   *   `CLINICAL_AUTHORING` with the other three and is stripped from ORG_OWNER
   *   and ORG_ADMIN by name.
   *
   *   Its own code rather than part of `ENCOUNTER_CREATE` because a clinic may
   *   reasonably let a junior clinician write up a first consultation and not
   *   let them restate a signed one. Splitting it costs one row in the matrix
   *   and makes that a decision the clinic can take.
   */
  ENCOUNTER_AMEND: 'clinical.encounter.amend',
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
  /**
   * Author the consultation CONFIGURATION: which sections a consultation has,
   * in what order, labelled how, over which vocabulary (CE-2).
   *
   * ⚠️ CONFIGURING A CONSULTATION IS NOT CONDUCTING ONE, AND THAT IS WHY THIS IS
   *   ITS OWN CODE RATHER THAN PART OF `CLINICAL_MASTER_MANAGE` OR OF THE
   *   AUTHORING SET. A template names no patient — it is administration, and it
   *   belongs with whoever sets the clinic up. A DOCTOR does not hold it and
   *   does not need it: they READ the resolved configuration behind
   *   `clinical.encounter.read`, which they already have, and changing what
   *   every colleague's consultation looks like is not an act of practising.
   *
   *   It is deliberately NOT excluded from ORG_OWNER and ORG_ADMIN the way
   *   `CLINICAL_AUTHORING` is: those roles are exactly who configures a clinic.
   */
  CLINICAL_TEMPLATE_MANAGE: 'clinical.template.manage',
  /**
   * Author the CHARTS a consultation draws on: the odontogram, the scalp map,
   * the body diagram, and the regions that make one up (CE-6).
   *
   * ⚠️ ITS OWN CODE, AND BESIDE `CLINICAL_TEMPLATE_MANAGE` RATHER THAN INSIDE
   *   IT. A template says WHICH chart a consultation shows; this says what the
   *   chart IS. They are configured by the same kind of person and are still
   *   two decisions — a clinic may reasonably let somebody rearrange the
   *   sections of its dentistry consultation without letting them redraw the
   *   tooth numbering every record in the practice is written against.
   *
   * ⚠️ AND IT IS NOT AN AUTHORING CODE. Drawing ON a chart is
   *   `clinical.encounter.create` and nothing else (CD-7) — recording a finding
   *   IS writing up the consultation. This code touches no patient data at all,
   *   which is why it is deliberately NOT excluded from ORG_OWNER and ORG_ADMIN
   *   the way `CLINICAL_AUTHORING` is: those roles are exactly who configures a
   *   clinic, and a DOCTOR neither holds it nor needs it.
   */
  CLINICAL_VISUAL_MAP_MANAGE: 'clinical.visual_map.manage',

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
  /*
   * Confirming that a prescription is fit to dispense, BEFORE anything leaves
   * the shelf (PI-7). Separate from `.create` on purpose, and the split is a
   * clinical-safety control rather than an administrative one:
   *
   *   `.verify`  a professional reads the prescription and says it is sound —
   *              the drug, the dose, the interaction, the patient.
   *   `.create`  somebody takes the boxes off the shelf and hands them over.
   *
   * ⚠️ A CLINIC MAY GRANT BOTH TO ONE PERSON, AND THE DEFAULTS DO — a dispensary
   *   with one pharmacist has nobody else, and pretending otherwise would make
   *   the system unusable at the shape of clinic this platform mostly serves.
   *   What the split buys is that a clinic which DOES separate the two can, by
   *   cloning a role, and that the record says which person did which act.
   *   Compare the requisition create/approve split in PI-4, which additionally
   *   refuses self-approval in the service — this one deliberately does not: a
   *   pharmacist verifying and then dispensing is the normal, lawful workflow.
   */
  DISPENSE_VERIFY: 'pharmacy.dispense.verify',
  DISPENSE_RETURN: 'pharmacy.dispense.return',
  /*
   * Online pharmacy (PI-12). THREE codes for a workflow that ends in a dispense,
   * and the split is where the risk changes rather than where the screens do.
   *
   *   `.read`      the order list, an order, where the parcel is. ⚠️ A BROADER
   *                DISCLOSURE THAN `.dispense.read`: an order carries a named
   *                person's HOME ADDRESS beside the medicines going to it, which
   *                is why reading one writes its own `data_access_logs` resource.
   *   `.manage`    taking the order, accepting it, standing it down. Accepting
   *                one HOLDS STOCK — `RESERVATION` movements the shelf then
   *                cannot sell — so this is a real inventory act and not data
   *                entry, which is why it is not folded into `.read`.
   *   `.dispatch`  handing the parcel to a carrier, closing out a delivery,
   *                recording a failure. Logistics: it moves no stock and decides
   *                no money, and it is routinely done by whoever is at the desk
   *                rather than by a pharmacist.
   *
   * ⚠️ AND PACKING IS GATED ON `pharmacy.dispense.create`, WHICH IS NOT A NEW
   *   CODE AND IS THE MOST IMPORTANT LINE IN THIS COMMENT. Making up the parcel
   *   IS the supply — it writes the dispense, moves the ledger and raises the
   *   charge request — so it is gated by the code that already means "this person
   *   may hand medicine over", not by a fourth online-specific one. A separate
   *   `.pack` code would be a second door to `pharmacy.dispense.create`'s
   *   authority, grantable to somebody a clinic had deliberately kept away from
   *   the counter.
   */
  ONLINE_ORDER_READ: 'pharmacy.online_order.read',
  ONLINE_ORDER_MANAGE: 'pharmacy.online_order.manage',
  ONLINE_ORDER_DISPATCH: 'pharmacy.online_order.dispatch',
  SUPPLIER_MANAGE: 'pharmacy.supplier.manage',
  PURCHASE_ORDER_READ: 'pharmacy.purchase_order.read',
  PURCHASE_ORDER_MANAGE: 'pharmacy.purchase_order.manage',
  GOODS_RECEIPT_MANAGE: 'pharmacy.goods_receipt.manage',

  // -- inventory -------------------------------------------------------------
  /*
   * `inventory.stock.read` IS THE GATE ON THE WHOLE SURFACE. Locations, batches,
   * serials, balances and the ledger are all read behind it, for the same reason
   * `product.definition.read` gates the catalogue masters rather than the manage
   * code: every stock screen needs the name of the shelf a thing is on, and
   * gating that behind the permission to CREATE shelves means a storekeeper sees
   * a page of uuids.
   */
  STOCK_READ: 'inventory.stock.read',
  STOCK_ADJUST: 'inventory.stock.adjust',
  STOCK_TRANSFER: 'inventory.stock.transfer',
  BATCH_MANAGE: 'inventory.batch.manage',
  /*
   * Creating and renaming the PLACES stock is kept, and their areas and bins.
   *
   * ⚠️ SEPARATE FROM `inventory.stock.adjust`, AND IT IS NOT A NARROWER VERSION
   *   OF IT. Adjusting stock is a daily operational act by whoever is holding
   *   the boxes; defining that a branch HAS a controlled-drug cabinet and a
   *   vaccine fridge is a configuration decision about how the site is
   *   organised, taken once, by whoever runs it. They are different people at
   *   most clinics, and the blast radius differs too: a bad adjustment is one
   *   compensating movement away from correct, while renaming or deactivating a
   *   location moves the meaning of every balance sitting under it.
   *
   * ⚠️ A LOCATION'S `kind` IS NEVER AN AUTHORIZATION. Holding this code does not
   *   grant access to what is IN a `CONTROLLED_CABINET`; `requires_controlled_
   *   access` and PI-5's jurisdiction rules answer that. See PI-ADR-012.
   */
  INVENTORY_LOCATION_MANAGE: 'inventory.location.manage',
  /*
   * Holding stock back for a pending dispense, an order or a booked procedure,
   * and giving it back again (PI-3.4).
   *
   * ⚠️ NOT COVERED BY `inventory.stock.adjust`, AND IT IS THE WEAKER OF THE TWO
   *   RATHER THAN A SUBSET. An adjustment CHANGES WHAT THE CLINIC HOLDS: it is a
   *   correction, it is where shrinkage hides, and it is why that code carries a
   *   mandatory reason. A reservation changes nothing about what is held — the
   *   quantity moves from AVAILABLE to RESERVED and back, and the branch's total
   *   is identical either side. It is the daily act of whoever is about to
   *   dispense, which is a wider group than whoever may correct a count.
   *
   *   In PI-7 dispensing will create these automatically, so a role that may
   *   dispense will need this. Introducing it now, separately, means that
   *   arrives as a grant rather than as a widening of `stock.adjust`.
   */
  STOCK_RESERVE: 'inventory.stock.reserve',
  /*
   * The controlled vocabulary an adjustment must cite (PI-3.1).
   *
   * ⚠️ A CONFIGURATION CODE, BESIDE `inventory.location.manage` AND FOR THE SAME
   *   REASON. Citing a reason code is a daily operational act covered by
   *   `stock.adjust`; DEFINING what reasons exist decides what every future
   *   adjustment can be filed under and what every shrinkage report can
   *   aggregate. Retiring `THEFT_OR_LOSS` is not an inventory correction, it is
   *   a decision about what the clinic is willing to record.
   *
   *   Reading them needs only `inventory.stock.read` — the picker on the
   *   adjustment form is on the surface that code gates.
   */
  INVENTORY_REASON_CODE_MANAGE: 'inventory.reason_code.manage',

  // -- procurement -----------------------------------------------------------
  /*
   * A branch asking for stock, and somebody else agreeing to buy it (PI-4.3).
   *
   * ⚠️ TWO CODES BECAUSE IT IS A SEGREGATION-OF-DUTY CONTROL, NOT A GRANULARITY
   *   PREFERENCE. One code would mean whoever raises a request approves it, which
   *   is the shape every procurement fraud in a small organization takes: the
   *   person who chooses the supplier, the quantity and the price is the person
   *   who signs it off. Splitting it is what makes "somebody else looked at this"
   *   a fact rather than a hope.
   *
   *   Mirrors the existing `doctor.schedule.request` / `.approve` split, and it is
   *   enforced in three places: these codes, a service check against the row's own
   *   `created_by_id`, and the `purchase_requisitions_approver_is_not_creator`
   *   CHECK — which is the only one a later phase cannot forget.
   *
   * ⚠️ A CLINIC MAY GRANT BOTH TO ONE PERSON, AND THAT IS DELIBERATELY POSSIBLE.
   *   A single-doctor clinic has nobody else, and refusing to let them buy
   *   anything would be a platform deciding how a business is staffed. What it
   *   still cannot do is self-approve one document, because the CHECK compares the
   *   two user ids rather than the two permissions.
   *
   * ⚠️ NEITHER OF THESE IS `pharmacy.purchase_order.*`, WHICH ALREADY EXISTS.
   *   Those two gate the COMMITMENT — raising and issuing the order that goes to
   *   the supplier. These gate the internal ASK that may precede it. A storekeeper
   *   who may request stock is not thereby somebody who may commit the clinic's
   *   money, and the roles below grant them to different people for that reason.
   *
   * ⚠️ AND `procurement.*` IS A NEW MODULE PREFIX RATHER THAN `pharmacy.*`. Under
   *   PI-ADR-001 procurement is not a pharmacy concern: a dental store manager
   *   requisitions composite filling material and a lab manager requisitions
   *   reagents, and neither should need a permission that also lets them dispense
   *   a controlled drug. The existing `pharmacy.supplier.*` and
   *   `pharmacy.purchase_order.*` codes predate that reasoning and are NOT
   *   renamed — a rename revokes a grant from every clinic that already holds it,
   *   which is the one thing a permission change must never do silently. Recorded
   *   in KNOWN_ISSUES instead.
   */
  REQUISITION_CREATE: 'procurement.requisition.create',
  REQUISITION_APPROVE: 'procurement.requisition.approve',

  // -- regulatory ------------------------------------------------------------
  /*
   * What a jurisdiction says may be done with a product (PI-5).
   *
   * ⚠️ A NEW MODULE RATHER THAN `pharmacy.*`, FOR PI-ADR-001's REASON AGAIN.
   *   Regulation is not a pharmacy concern: a device implanted by a surgeon, a
   *   reagent a lab imports and a veterinary medicine are each regulated, and
   *   none of them belongs to whoever may dispense a controlled drug.
   *
   * ── THE THREE CLASSES OF THING IN THIS MODULE ─────────────────────────────
   *   READ the law            everybody who works with stock, effectively
   *   ASSERT a product's      whoever curates the catalogue for a clinic
   *     nature per country
   *   APPROVE a rule pack     one named human, and nobody by default
   */
  /**
   * Read the jurisdictions, authorities, packs, rules and sources.
   *
   * ⚠️ THE GATE ON THE WHOLE REGULATORY SURFACE, in the same shape as
   *   `inventory.stock.read`. Everything here is published law rather than
   *   anybody's private data, and a pharmacist who cannot read the rule that
   *   refused a dispense is a pharmacist who cannot explain it to the patient
   *   standing there. There is deliberately no tenant-side write to match it:
   *   a clinic never writes a rule pack.
   */
  REGULATORY_READ: 'regulatory.rule.read',
  /**
   * Maintain the packs, rules, jurisdictions, authorities and sources.
   *
   * ⚠️ A PLATFORM CODE THAT LIVES IN THE `regulatory` MODULE RATHER THAN THE
   *   `platform` ONE, and the exception is deliberate: it sits beside the read
   *   it is the write half of, and every screen it gates is a regulatory screen.
   *   It is granted to no system role — like `platform.*`, it is held by rcln's
   *   own staff, and the platform router's admin guard is what actually enforces
   *   the boundary. `platform.tax.manage` is its closest analogue and made the
   *   opposite naming choice; that one predates the module.
   *
   * ⚠️ IT DOES NOT REACH THE LAST TWO MATURITIES. See `REGULATORY_PACK_APPROVE`.
   */
  REGULATORY_MANAGE: 'regulatory.rule.manage',
  /**
   * Advance a rule pack to `REGULATORY_REVIEWED` or `PRODUCTION_ENABLED`.
   *
   * ⚠️ THE ONLY PERMISSION IN THIS CODEBASE THAT NO SYSTEM ROLE HOLDS, INCLUDING
   *   `ORG_OWNER` — which is defined as "everything except" and therefore has to
   *   be told, by name, to leave this alone. That is the whole point of
   *   PI-ADR-009: a country configuration existing is not compliance, and the
   *   step from "we tested it" to "we act on it in production" belongs to a
   *   qualified human with the authority to make it — in-house counsel, a
   *   retained regulatory consultant, a pharmacist with the relevant
   *   registration. Whoever that is at a given company is granted this code on
   *   their membership, deliberately, once, out of band.
   *
   * ⚠️ NO MIGRATION, SEED, SCRIPT OR AGENT MAY SET THOSE TWO STATES, and holding
   *   this code is not the same as being able to skip the ladder: the service
   *   refuses a pack that has not reached `REGULATORY_REVIEW_PENDING`, and the
   *   `regulatory_rule_packs_review_recorded` CHECK refuses either state without
   *   a reviewer's name and the instant it was recorded. Three layers, because
   *   the failure this guards against is somebody's medicine.
   */
  REGULATORY_PACK_APPROVE: 'regulatory.pack.approve',
  /**
   * Record what a product IS in a jurisdiction: its registration, its
   * classification, its schedule, whether it may be sold remotely.
   *
   * ⚠️ NOT `product.definition.manage`, AND THE SPLIT IS THE SAME ONE PI-ADR-011
   *   ALREADY DREW. Naming a product and describing it is catalogue curation;
   *   asserting that it is a Schedule H medicine in India is a claim the clinic
   *   is answerable for at an inspection. A lab manager names reagents and has
   *   no business asserting either.
   *
   * ⚠️ AND AN ASSERTION IS NOT AN AUTHORISATION. Nothing gates a dispense on a
   *   profile; the RULES decide, and a jurisdiction with no rule refuses however
   *   confidently the profile is filled in.
   */
  PRODUCT_REGULATORY_READ: 'product.regulatory.read',
  PRODUCT_REGULATORY_MANAGE: 'product.regulatory.manage',

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
  /*
   * Charging — the hand-off between what was supplied and what is billed (PI-8).
   *
   * ⚠️ THE READ IS HELD WHEREVER SUPPLIES HAPPEN, THE MANAGE WHEREVER MONEY IS
   *   DECIDED, AND THAT SPLIT IS THE WHOLE DESIGN. A pharmacist has to see that
   *   the medicine they handed over reached the charge queue — a supply that
   *   silently produced no charge request is invisible until the month-end
   *   figures are wrong. They have no business deciding whether it is billed.
   *
   * ⚠️ THE MANAGE IS NOT `billing.invoice.create`, AND THE DISTINCTION IS THE
   *   ONE `charge_requests` EXISTS FOR. Raising an invoice is assembling a
   *   document from charges somebody already approved; this is the approval —
   *   answering an `OPTIONAL` policy, or suppressing a charge so that nobody is
   *   billed at all. Folding it into the invoice code would mean every cashier
   *   who can raise a bill can also decide, unlogged as a separate act, that a
   *   supply is free.
   *
   * ⚠️ NO SEPARATE PRICING CODE, DELIBERATELY. What a clinic charges for a
   *   product is gated by `billing.fee_schedule.manage`, which already means
   *   exactly "may set what this clinic charges" and already carries the
   *   reasoning above about why that is not BRANCH_ADMIN's. A second pricing
   *   permission beside it is how a screen quotes one number and the bill states
   *   another.
   */
  CHARGE_REQUEST_READ: 'billing.charge_request.read',
  CHARGE_REQUEST_MANAGE: 'billing.charge_request.manage',
  /*
   * The standing answer to "is this product billed at all?".
   *
   * ⚠️ ITS OWN CODE RATHER THAN `CHARGE_REQUEST_MANAGE`, because the blast radii
   *   differ by orders of magnitude. Deciding one `OPTIONAL` charge affects one
   *   patient; editing the policy decides every future supply of that product at
   *   every branch, silently and with no row to review. Same argument
   *   FEE_SCHEDULE_MANAGE makes against being an invoice code.
   */
  CHARGE_POLICY_MANAGE: 'billing.charge_policy.manage',
  PAYMENT_COLLECT: 'billing.payment.collect',
  /*
   * ⚠️ SEEDED SINCE PHASE 3 AND UNREACHABLE UNTIL PI-8. `voidInvoice`'s header
   *   recorded the gap: a void that reduces a reported tax liability is
   *   corrected with a credit note, and there was no table, no series and no
   *   `CREDIT_NOTE` kind to put one in. PI-8 built all three, and this is the
   *   code that gates issuing one.
   */
  CREDIT_NOTE_ISSUE: 'billing.credit_note.issue',
  REFUND_PROCESS: 'billing.refund.process',
  DOCTOR_PAYOUT_MANAGE: 'billing.doctor_payout.manage',

  // -- clinical consumption --------------------------------------------------
  /*
   * What a procedure actually used off the shelf (PI-9).
   *
   * ⚠️ A NEW MODULE PREFIX RATHER THAN `inventory.*` OR `clinical.*`, AND BOTH
   *   ALTERNATIVES ARE WRONG IN OPPOSITE DIRECTIONS.
   *
   *   Not `inventory.stock.adjust`: a dentist recording three pairs of gloves is
   *   not correcting a count, and gating consumption behind the adjustment code
   *   would hand every clinician the permission where shrinkage hides. It is
   *   also the weaker act — an adjustment changes what the clinic HOLDS with no
   *   external event behind it, while a consumption records a physical event
   *   somebody witnessed.
   *
   *   Not `clinical.*`: consumption writes NO clinical record (invariant 7). It
   *   is a stock movement anchored to a consultation, the same relationship
   *   `prescription_fulfilments` has to a prescription, and PI-7's route-gate
   *   test asserts pharmacy carries no `clinical.*` code for exactly this
   *   reason. A `clinical.consumption.record` code would additionally be
   *   stripped from ORG_OWNER and ORG_ADMIN by the `CLINICAL_AUTHORING` list,
   *   which would be wrong: an administrator reconciling a treatment room's
   *   trolley is not authoring a chart.
   */
  CONSUMPTION_READ: 'consumption.record.read',
  CONSUMPTION_RECORD: 'consumption.record',
  /*
   * Departing from what the template expected.
   *
   * ⚠️ ITS OWN CODE, AND THE SPLIT IS THE ONE CLINICAL_CONSUMPTION.md ASKS FOR
   *   BY NAME: "recording what was used and overriding the expected quantity are
   *   different acts, and the second is the one a variance report cares about".
   *
   * ⚠️ AND HOLDING IT NEVER BLOCKS A CLINICIAN — the whole design refuses to
   *   obstruct. What the code buys is that a clinic which wants variances
   *   approved by a named person can arrange it by NOT granting this to
   *   everyone; the defaults grant it to whoever holds `.record`, because a
   *   dentist who used three pairs of gloves used three pairs of gloves and a
   *   system that argues gets an inventory that stops matching reality.
   */
  CONSUMPTION_OVERRIDE: 'consumption.override',
  /*
   * Writing the templates themselves.
   *
   * ⚠️ A CONFIGURATION CODE, BESIDE `inventory.reason_code.manage` AND FOR THE
   *   SAME REASON. Recording a consumption is a daily operational act; deciding
   *   what a root canal is EXPECTED to consume sets the baseline every future
   *   variance is measured against, at every branch, and quietly restates what
   *   "normal" means for a procedure the clinic bills for.
   *
   *   Reading a template needs only `consumption.record.read` — the pre-filled
   *   panel is on the surface that code gates.
   */
  CONSUMPTION_TEMPLATE_MANAGE: 'consumption.template.manage',

  // -- recall & traceability -------------------------------------------------
  /*
   * A manufacturer's or regulator's notice, and the work it starts (PI-10).
   *
   * ⚠️ READING A RECALL IS NOT READING WHO RECEIVED IT. `recall.read` opens the
   *   notice, the lots it names and the COUNTS of supplies and procedures that
   *   touched them. Resolving those counts to named patients is a second,
   *   separately-gated, separately-logged act — see `RECALL_TRACE_PATIENTS`
   *   below and TRACEABILITY.md § "Patient linkage and its limits". A recall
   *   that handed a storekeeper a patient list because they can read a lot
   *   number would be the largest single PHI disclosure this platform can make.
   */
  RECALL_READ: 'recall.notice.read',
  /*
   * Recording the notice and assembling its scope. ⚠️ WRITES NO MOVEMENT — a
   *   DRAFT recall holds nothing, deliberately, so a half-built scope does not
   *   stop a pharmacy mid-shift.
   */
  RECALL_CREATE: 'recall.notice.create',
  /*
   * Pulling the stock.
   *
   * ⚠️ ITS OWN CODE, AND THE SPLIT IS THE `requisition.create` / `.approve`
   *   SHAPE APPLIED TO STOCK. Recording that a notice arrived is clerical;
   *   executing it moves quantity at every branch in one transaction and makes
   *   the product un-dispensable across the organization. A clinic that wants
   *   the second decision taken by a named person arranges it by not granting
   *   this to everyone who can raise the first.
   *
   * ⚠️ AND IT IS NOT A NARROWER `inventory.batch.manage`. That code already
   *   quarantines ONE lot at ONE branch through `POST /batches/:id/hold`, which
   *   is the storekeeper's daily act. This is the same movement applied to
   *   every lot a notice names, wherever it sits, from one screen.
   */
  RECALL_EXECUTE: 'recall.notice.execute',
  /*
   * Turning the counts into names.
   *
   * ⚠️ THE ONE PHI CODE IN THIS MODULE, AND IT IS NOT IMPLIED BY ANY OF THE
   *   THREE ABOVE. TRACEABILITY.md is explicit that the LINK always exists in
   *   the data — a recall that cannot reach the people who took the product is
   *   not a recall — while WHO MAY SEE IT is an access-control question. So the
   *   trace report answers "37 supplies, 4 procedures" under `recall.read`, and
   *   answers "these 37 people" only here, and every such read writes a
   *   `data_access_logs` row.
   */
  RECALL_TRACE_PATIENTS: 'recall.trace.patients',

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
